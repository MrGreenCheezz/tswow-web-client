import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

/**
 * The client's patch chain, opened once for this file: `clientArchives` hands every caller in the
 * process the same chain, so a test that closed it would leave the next one reading nothing.
 */
let chainOpened;
const clientChain = async () => {
  chainOpened ??= import("../tools/mpq.mjs").then(({ clientArchives }) => clientArchives(clientDirectory));
  return await chainOpened;
};
test.after(async () => {
  if (chainOpened) (await chainOpened).close();
});

/** A glue runtime over the real corpus, with whatever C-side options the test hands it. */
async function corpusRuntime(api = {}) {
  const chain = await clientChain();
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const luaErrors = [];
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder().decode(data) : undefined;
      },
    },
    lua: { onError: (message) => luaErrors.push(message) },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768, ...api },
  });
  const result = await runtime.load();
  return { runtime, result, luaErrors };
}

/** 18 px a line and 50 characters a line: a long string is a tall one. */
const lines = (text) => Math.max(1, Math.ceil(String(text ?? "").length / 50));

/**
 * The host cannot measure a hidden FontString: GlueDialogText reads 0 px tall until GlueDialog is
 * shown, and its real height after. That is the page's behaviour the re-measure exists for.
 */
function measureDialogText(runtime) {
  const dialog = runtime.bridge.getFrame("GlueDialog");
  const background = runtime.bridge.getFrame("GlueDialogBackground");
  const label = runtime.bridge.getFrame("GlueDialogText");
  assert.ok(dialog !== undefined && background !== undefined && label !== undefined);
  runtime.bridge.setMeasure((frame) => frame === label
    ? { width: 450, height: dialog.visible ? 18 * lines(label.text) : 0 }
    : undefined);
  return { dialog, background, label };
}

/** `GlueDialog_OnEvent`'s UPDATE_STATUS_DIALOG: 32 + text + 8 + a 40 px button + 16. */
const remeasured = (text) => 32 + 18 * lines(text) + 8 + 40 + 16;

/**
 * 3.35-bounds (03.10): the HTML twin's box. FUN_004d80c0 opens OKAY_HTML for a login result whose
 * string holds "<HTML>"; GlueDialog_Show sizes GlueDialogBackground as 16 + text + 8 + button + 16 with
 * the text's height from `GlueDialogHTML:GetBoundsRect()` (GlueDialog.lua:607-630) — Wow.exe 0x0049e700,
 * whose CSimpleFrame +0x64 (0x004913c0) takes in the page's paragraphs (regions of the widget).
 * Here every character is 9 units wide, so a 450-unit line holds 50; a word longer than that is cut.
 */
const CHAR = 9;
function wrappedLines(text, width) {
  const chars = Math.floor(width / CHAR);
  let lines = 0;
  let line = "";
  for (let word of text.split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if ([...candidate].length <= chars) { line = candidate; continue; }
    if (line !== "") lines += 1;
    while ([...word].length > chars) { lines += 1; word = [...word].slice(chars).join(""); }
    line = word;
  }
  return lines + 1;
}

test("an HTML auth refusal opens OKAY_HTML, its box sized from the page while the dialog is hidden", withClient, async () => {
  const { parseFrameXmlSimpleHtml } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtml.js");
  const { plainFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");
  const { runtime, luaErrors } = await corpusRuntime({
    authUrl: "ws://fixture.invalid/auth",
    connect: async () => ({
      send() {},
      async readExactly(length) {
        assert.equal(length, 3);
        return Uint8Array.of(0, 0, 4);
      },
      close() {},
    }),
  });
  try {
    const { dialog, background, label } = measureDialogText(runtime);
    runtime.bridge.setTextMeasure((_frame, text) => CHAR * [...text].length);
    const html = runtime.bridge.getFrame("GlueDialogHTML");
    await runtime.api.login("NONEXISTENT", "irrelevant");
    assert.deepEqual(luaErrors, []);
    assert.equal(dialog.visible, true);
    // 0x04 is the client's LOGIN_UNKNOWN_ACCOUNT (FUN_008cb160), written as markup in the corpus.
    const markup = runtime.vm.globalString("LOGIN_UNKNOWN_ACCOUNT");
    assert.match(markup ?? "", /<html>/i);
    assert.equal(html.visible, true, "GlueDialogHTML draws it");
    assert.equal(label.visible, false, "GlueDialogText is hidden");
    assert.equal(html.text, markup, "the page as written");
    const [block] = parseFrameXmlSimpleHtml(markup, html.attributes.hyperlinkFormat);
    const lines = wrappedLines(plainFrameXmlText(block.text), 450);
    assert.ok(lines > 1, `a refusal long enough to need the height: ${lines} lines`);
    const font = runtime.bridge.fontObjectStyle("GlueFontNormalLarge");
    const textHeight = Math.max(30, lines * font.height + (lines - 1) * 2);
    assert.equal(Number(background.attributes.height), 16 + textHeight + 8 + 40 + 16,
      "GlueDialog_Show's own sum, with GetBoundsRect's height of the page");
  } finally {
    runtime.close();
  }
});

test("the HTML refusal dismisses with Enter and Escape, a new login shows it again; a broken measure still shows a dialog (3.35-review)", withClient, async () => {
  const { flattenHtmlMessage } = await import("../dist/code/browser/glue/GlueMessages.js");
  const { runtime, luaErrors } = await corpusRuntime({
    authUrl: "ws://fixture.invalid/auth",
    connect: async () => ({
      send() {},
      async readExactly() { return Uint8Array.of(0, 0, 4); },
      close() {},
    }),
  });
  const which = () => {
    runtime.vm.setGlobal("__which", undefined);
    assert.equal(runtime.vm.execute("__which = GlueDialog.which", "@glue-auth-dialog-layout").ok, true);
    return runtime.vm.getGlobal("__which");
  };
  const key = (name) => assert.equal(runtime.vm.execute(`GlueDialog_OnKeyDown("${name}")`, "@glue-auth-dialog-layout").ok, true);
  try {
    const { dialog, label } = measureDialogText(runtime);
    const html = runtime.bridge.getFrame("GlueDialogHTML");
    // A page block's measure (its probe is no frame of its own) that throws: GetBoundsRect raises a Lua
    // error inside GlueDialog_Show, before GlueDialog:Show().
    let broken = true;
    runtime.bridge.setTextMeasure((frame, text) => {
      if (broken && frame.type === undefined) throw new Error("measure broke");
      return CHAR * [...text].length;
    });
    const markup = runtime.vm.globalString("LOGIN_UNKNOWN_ACCOUNT");
    await runtime.api.login("NONEXISTENT", "irrelevant");
    // The corpus' own handler (GlueBasicControls.xml: _ERRORMESSAGE → ScriptErrors) shows the Lua error…
    assert.match(runtime.bridge.getFrame("ScriptErrors_Message")?.text ?? "", /measure broke/);
    // …and the refusal is said all the same.
    assert.equal(dialog.visible, true, "a dialog all the same");
    assert.equal(which(), "OKAY", "the plain dialog, as before 3.35");
    assert.equal(label.visible, true);
    assert.equal(html.visible, false);
    assert.equal(label.text, flattenHtmlMessage(markup));
    key("ENTER");
    assert.equal(dialog.visible, false, "OKAY dismisses it");

    broken = false;
    luaErrors.length = 0;
    await runtime.api.login("NONEXISTENT", "irrelevant");
    assert.deepEqual(luaErrors, []);
    assert.equal(dialog.visible, true);
    assert.equal(which(), "OKAY_HTML");
    assert.equal(html.visible, true);
    key("ENTER");
    assert.equal(dialog.visible, false, "Enter clicks OKAY");
    await runtime.api.login("NONEXISTENT", "irrelevant");
    assert.equal(which(), "OKAY_HTML", "a new login shows it again");
    assert.equal(dialog.visible, true);
    key("ESCAPE");
    assert.equal(dialog.visible, false, "Escape clicks the only button");
    assert.deepEqual(luaErrors, []);
  } finally {
    runtime.close();
  }
});

test("auth rejection remeasures the stock status dialog after it becomes visible", withClient, async () => {
  const { runtime, luaErrors } = await corpusRuntime({
    authUrl: "ws://fixture.invalid/auth",
    connect: async () => ({
      send() {},
      async readExactly(length) {
        assert.equal(length, 3);
        return Uint8Array.of(0, 0, 6);
      },
      close() {},
    }),
  });
  try {
    const { dialog, background, label } = measureDialogText(runtime);
    await runtime.api.login("NONEXISTENT", "irrelevant");
    assert.deepEqual(luaErrors, []);
    assert.equal(dialog.visible, true);
    // 0x06 is the client's LOGIN_ALREADYONLINE (FUN_008cb160), plain text in the corpus. (0x04's
    // LOGIN_UNKNOWN_ACCOUNT is markup and opens OKAY_HTML since 3.35-bounds, the test above.)
    assert.equal(label.text, runtime.vm.globalString("LOGIN_ALREADYONLINE"));
    assert.ok(lines(label.text) > 1, "a refusal long enough to need the height");
    assert.equal(Number(background.attributes.height), remeasured(label.text),
      "stock UPDATE_STATUS_DIALOG sizes its box from the visible text and button");
  } finally {
    runtime.close();
  }
});

/** One character on one realm, a world that refuses whatever it is asked, and a creation screen. */
async function refusingWorld({ deleteResult = 71, createResult = 47 } = {}) {
  const { fakeGlueSession } = await import("../dist/code/browser/glue/GlueFakeSession.js");
  const canned = fakeGlueSession("charselect");
  const human = {
    id: 1, name: "Человек", clientPrefix: "Hu", clientFileString: "Human", playable: true, side: 0,
    factionId: 1, baseLanguage: 7, expansion: 0, maleDisplayId: 49, femaleDisplayId: 50,
    hairCustomization: "NORMAL", facialHairCustomization: ["NORMAL", "NORMAL"], classes: [1],
  };
  const warrior = { id: 1, name: "Воин", fileName: "WARRIOR", classMask: 1, powerType: 1, expansion: 0, playable: true };
  const built = await corpusRuntime({
    session: {
      connect: async () => ({
        characters: async () => [...(await (await canned.connect()).characters())],
        deleteCharacter: async () => deleteResult,
        createCharacter: async () => createResult,
        close: () => {},
      }),
    },
    creation: {
      source: { options: async () => undefined, startOutfit: async () => [], displayId: () => undefined },
      tables: () => ({ races: [human], classes: [warrior] }),
    },
  });
  built.runtime.session.beginSession(canned.auth);
  await built.runtime.session.connect(canned.realm);
  return built;
}

test("a refused delete remeasures the stock dialog for its long reason", withClient, async () => {
  const { runtime, luaErrors } = await refusingWorld({ deleteResult: 74 });
  try {
    const { dialog, background, label } = measureDialogText(runtime);
    assert.equal(await runtime.session.deleteCharacter(1), 74);
    assert.deepEqual(luaErrors, []);
    assert.equal(dialog.visible, true);
    assert.equal(label.text, runtime.vm.globalString("CHAR_DELETE_FAILED_GUILD_LEADER"));
    assert.ok(lines(label.text) > 1, `a long reason: ${String(label.text).length} characters`);
    assert.equal(Number(background.attributes.height), remeasured(label.text));
  } finally {
    runtime.close();
  }
});

test("a refused create remeasures the stock dialog for its long reason", withClient, async () => {
  // 60: one hero-class character per realm — the longest create refusal in the corpus' wording.
  const { runtime, luaErrors } = await refusingWorld({ createResult: 60 });
  try {
    const { dialog, background, label } = measureDialogText(runtime);
    assert.equal(await runtime.api.creation.createCharacter("Аларин"), 60);
    assert.deepEqual(luaErrors, []);
    assert.equal(dialog.visible, true);
    assert.equal(label.text, runtime.vm.globalString("CHAR_CREATE_UNIQUE_CLASS_LIMIT"));
    assert.ok(lines(label.text) > 1, `a long reason: ${String(label.text).length} characters`);
    assert.equal(Number(background.attributes.height), remeasured(label.text));
  } finally {
    runtime.close();
  }
});

/** The tiny DOM `glue-corpus.test.mjs` mounts the renderer on. */
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
      ownerDocument: doc,
      tagName: tag.toUpperCase(),
      children: [],
      parentElement: undefined,
      style,
      hidden: false,
      className: "",
      textContent: "",
      value: "",
      disabled: false,
      classList: { add(...names) { node.className = [...names].join(" "); } },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      append(...children) {
        for (const child of children) {
          child.parentElement = node;
          node.children.push(child);
        }
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

/** Every non-empty `textContent` under `node`. */
function texts(node, found = []) {
  if (node.textContent) found.push(node.textContent);
  for (const child of node.children) texts(child, found);
  return found;
}

/** The element the renderer drew for the frame `name`. */
function drawn(root, name) {
  if (root.getAttribute?.("data-framexml-name") === name) return root;
  for (const child of root.children) {
    const found = drawn(child, name);
    if (found) return found;
  }
  return undefined;
}

test("an <html> refusal reaches the page as text, not as an empty SimpleHTML box", withClient, async () => {
  const previous = globalThis.document;
  globalThis.document = fakeDocument();
  let renderer;
  let built;
  try {
    const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
    const { parseFrameXmlSimpleHtml } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtml.js");
    const { plainFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");
    built = await corpusRuntime({
      authUrl: "ws://fixture.invalid/auth",
      connect: async () => ({
        send() {},
        async readExactly() { return Uint8Array.of(0, 0, 4); },
        close() {},
      }),
    });
    const { runtime, result, luaErrors } = built;
    const host = document.createElement("section");
    renderer = new FrameXmlDomRenderer(host, { bridge: runtime.bridge });
    renderer.mount(result.roots);
    await runtime.api.login("NONEXISTENT", "irrelevant");
    runtime.tick(0.016);
    assert.deepEqual(luaErrors, []);

    const markup = runtime.vm.globalString("LOGIN_UNKNOWN_ACCOUNT");
    assert.match(markup ?? "", /<html>/i, "the corpus writes this refusal as markup");
    // 3.35-bounds (03.10): OKAY_HTML, as FUN_004d80c0 opens it — GlueDialogHTML draws the page, its link
    // in the widget's hyperlinkFormat (`[%s]` in green).
    const page = drawn(host, "GlueDialogHTML");
    assert.ok(page, "GlueDialogHTML is drawn");
    const layer = page.children.find((child) => child.getAttribute("data-framexml-html-layer") === "true");
    const [block] = parseFrameXmlSimpleHtml(markup, runtime.bridge.getFrame("GlueDialogHTML").attributes.hyperlinkFormat);
    const expected = plainFrameXmlText(block.text);
    assert.equal(texts(layer).join(""), expected, `the refusal is drawn: ${expected}`);
    const onPage = texts(host);
    assert.ok(!onPage.some((text) => /<html|<a |<p[ >]/i.test(text)), "no markup is drawn as text");
  } finally {
    renderer?.destroy();
    built?.runtime.close();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
