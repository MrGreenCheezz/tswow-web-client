import assert from "node:assert/strict";
import test from "node:test";

// The corpus this slice exists to run is the client's own, so this file reads
// it straight out of the MPQ patch chain. A machine without the 3.3.5a client
// skips cleanly; the fixture-driven tests next door still cover the mechanism.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

/**
 * The same tiny DOM seam the framexml_compat tests use, plus the two pieces the
 * grown renderer touches: a `head` for `@font-face`, and `value`/`disabled` for
 * an EditBox. Keeping it explicit is what makes "the renderer never reaches for
 * a browser API we did not name" checkable.
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
      addEventListener(name, listener) {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
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

globalThis.document = fakeDocument();
const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");

function countElements(node) {
  let total = 1;
  for (const child of node.children) total += countElements(child);
  return total;
}

test("the real GlueXML corpus loads through the runtime with no Lua errors", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const provider = {
    async read(path) {
      const data = await chain.read(path.replaceAll("/", "\\"));
      return data ? new TextDecoder("utf-8").decode(data) : undefined;
    },
  };

  const luaErrors = [];
  const stubs = { global: [], method: [] };
  const runtime = new GlueRuntime({
    provider,
    lua: { onError: (message) => luaErrors.push(message) },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768 },
    onStub: (kind, name) => stubs[kind].push(name),
  });
  const result = await runtime.load();

  // The whole point of the slice: the screen must load without a Lua error.
  assert.deepEqual(luaErrors, [], "unhandled Lua errors while loading the corpus");
  assert.deepEqual(runtime.vm.errors, []);
  assert.deepEqual(result.diagnostics, [], "no XML or provider diagnostics");

  // The TOC's entries are the client's; only its absent ones are skipped, and
  // `..\SharedXML\SharedGlueStrings.lua` is absent from the locale chain.
  assert.ok(result.tocEntries.length >= 30, `TOC entries: ${result.tocEntries.length}`);
  assert.ok(result.loaded.length >= 50, `loaded files: ${result.loaded.length}`);
  assert.ok(result.templates.length >= 100, `templates: ${result.templates.length}`);
  assert.ok(runtime.bridge.fontStyles.length >= 50, `font objects: ${runtime.bridge.fontStyles.length}`);

  const login = runtime.bridge.getFrame("AccountLogin");
  assert.ok(login, "AccountLogin exists");
  assert.equal(login.loaded, true, "AccountLogin's OnLoad ran");
  assert.equal(login.visible, false, "AccountLogin starts hidden, as its XML declares");
  assert.ok(runtime.bridge.getFrame("GlueParent"), "GlueParent exists");
  assert.ok(runtime.bridge.frames.length >= 1000, `widgets: ${runtime.bridge.frames.length}`);

  // OnShow is what the screen transition actually runs; hook it before asking
  // for the screen so the assertion is about the dispatch, not a side effect.
  let shows = 0;
  runtime.bridge.HookScript(login, "OnShow", () => { shows += 1; });
  assert.equal(runtime.api.setGlueScreen("login"), true);
  assert.equal(runtime.api.currentScreen, "login");
  assert.equal(login.visible, true);
  assert.equal(shows, 1, "AccountLogin's OnShow ran exactly once");
  assert.deepEqual(luaErrors, [], "unhandled Lua errors while showing the login screen");

  // G4's two screens: both must exist, both must have run their OnLoad, and showing the one the
  // realm dialog leads to must not raise a Lua error. `CharacterSelect_OnLoad` is the demanding
  // one — it calls `self:SetSequence`, `SetCharSelectModelFrame` and two backdrop-colour setters
  // before anything is connected.
  const realmList = runtime.bridge.getFrame("RealmList");
  const characterSelect = runtime.bridge.getFrame("CharacterSelect");
  assert.ok(realmList, "RealmList exists");
  assert.ok(characterSelect, "CharacterSelect exists");
  assert.equal(realmList.loaded, true, "RealmList's OnLoad ran");
  assert.equal(characterSelect.loaded, true, "CharacterSelect's OnLoad ran");
  assert.equal(characterSelect.type, "ModelFFX", "the character-select backdrop is the screen itself");
  assert.ok(runtime.bridge.getFrame("CharSelectCharacterButton1"), "the character rows exist");

  assert.equal(runtime.api.setGlueScreen("charselect"), true);
  assert.equal(runtime.api.currentScreen, "charselect");
  assert.equal(characterSelect.visible, true);
  assert.deepEqual(luaErrors, [], "unhandled Lua errors while showing the character-select screen");
  // With no session there are no characters, and the corpus must draw that rather than fail on it.
  assert.equal(runtime.session.characters.length, 0);
  assert.equal(runtime.bridge.getFrame("CharSelectEnterWorldButton")?.enabled, false,
    "no characters means the enter-world button is disabled, as UpdateCharacterList decides");

  // How the stock character screens are lit, straight out of the corpus. `SetBackgroundModel`
  // hands off to `SetLighting`, which calls `ResetLights()` and then adds `RaceLights[race]`
  // through `AddLight` — three lights for a human (`GlueParent.lua:52-56`), the first of them a
  // pure ambient 0.27 grey and the third a warm key at intensity 2. Until G7 all three were
  // recorded and dropped, and the stage lit every backdrop with a constant nobody had measured.
  assert.equal(
    runtime.vm.execute('SetBackgroundModel(CharacterSelect, "Human")', "g7-lighting").ok, true);
  assert.deepEqual(luaErrors, [], "unhandled Lua errors while lighting the backdrop");
  assert.equal(characterSelect.model.file, "Interface\\Glues\\Models\\UI_Human\\UI_Human.m2");
  assert.equal(characterSelect.model.lights?.length, 3, "RaceLights.HUMAN is three lights");
  assert.deepEqual(characterSelect.model.lights?.[0], [1, 0, 0, 0, -1, 1, 0.27, 0.27, 0.27, 1, 0, 0, 0]);
  assert.equal(characterSelect.model.lights?.[2]?.[9], 2, "the warm key is authored at intensity 2");
  // `ResetLights` is the only thing that empties the set, exactly as the corpus' own comment says.
  assert.equal(runtime.vm.execute("CharacterSelect:ResetLights()", "g7-reset").ok, true);
  assert.equal(characterSelect.model.lights, undefined);

  // The realm dialog draws itself from the same empty session.
  runtime.bridge.Show(realmList);
  assert.deepEqual(luaErrors, [], "unhandled Lua errors while showing the realm list");
  runtime.bridge.Hide(realmList);

  // G5's screen. `CharacterCreate_OnShow` is the most demanding OnShow in the corpus: it calls
  // ResetCharCustomize, enumerates races and classes positionally, sets the race, the class and the
  // gender, and prints three GlueStrings keys built out of GetHairCustomization(). With no gateway
  // every list is empty, which is what a client that cannot reach one sees — and it must still not
  // raise a Lua error.
  const characterCreate = runtime.bridge.getFrame("CharacterCreate");
  assert.ok(characterCreate, "CharacterCreate exists");
  assert.equal(characterCreate.loaded, true, "CharacterCreate's OnLoad ran");
  assert.equal(characterCreate.type, "ModelFFX", "the creation backdrop is the screen itself");
  assert.equal(runtime.api.setGlueScreen("charcreate"), true);
  assert.equal(runtime.api.currentScreen, "charcreate");
  assert.equal(characterCreate.visible, true);
  assert.equal(characterSelect.visible, false, "SetGlueScreen hides the screen it left");
  assert.deepEqual(luaErrors, [], "unhandled Lua errors while showing the character-create screen");
  // `toplevel="true"` is what puts a shown screen in front of everything else in its strata — see
  // `raiseToplevel`. Both screens declare it, so the one just shown must outrank the one it left.
  assert.equal(characterCreate.toplevel, true, "CharacterCreate declares toplevel");
  assert.ok(characterCreate.frameLevel > characterSelect.frameLevel,
    `charcreate level ${characterCreate.frameLevel} vs charselect ${characterSelect.frameLevel}`);
  runtime.tick(0.016);
  assert.deepEqual(luaErrors, [], "unhandled Lua errors on the creation screen's OnUpdate");

  assert.equal(runtime.api.setGlueScreen("login"), true);

  // The DOM layer has to survive the real widget count, not just a fixture.
  const host = document.createElement("section");
  const renderer = new FrameXmlDomRenderer(host, { bridge: runtime.bridge });
  renderer.mount(result.roots);
  assert.ok(countElements(host) >= 1000, `rendered elements: ${countElements(host)}`);

  // A frame of OnUpdate must not error either; the corpus fades on it.
  runtime.tick(0.016);
  assert.deepEqual(luaErrors, []);

  // This list is the deliverable for G3/G4 planning: every C-API global and
  // widget method the real corpus reached that only recorded.
  console.log(`[glue corpus] files=${result.loaded.length} widgets=${runtime.bridge.frames.length} `
    + `templates=${result.templates.length} fonts=${runtime.bridge.fontStyles.length}`);
  console.log(`[glue corpus] skipped=${result.missing.join(", ")}`);
  console.log(`[glue corpus] lua5.1-escape chunks=${runtime.vm.relaxedChunks.join(", ")}`);
  console.log(`[glue corpus] stub C-API=${stubs.global.join(", ")}`);
  console.log(`[glue corpus] stub methods=${stubs.method.join(", ")}`);
  assert.ok(stubs.global.length < 40, `stubbed C-API globals: ${stubs.global.length}`);

  renderer.destroy();
  runtime.close();
  chain.close();
});
