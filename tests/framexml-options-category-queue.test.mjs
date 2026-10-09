import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.18: an add-on (or a TSWoW block) files its options panel with InterfaceOptions_AddCategory
// while it loads. In the client InterfaceOptionsFrame.lua is ordinary FrameXML and the panel lands in
// the «AddOns» tab (InterfaceOptionsFrame.lua:585-650); here the chain loads on the first open, so
// the call is kept and replayed into the real function (FrameXmlOptionsCategoryQueue.ts).
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { loadFrameXmlOptionsChain } = await import("../dist/code/browser/framexml/FrameXmlOptionsOwner.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "options-queue-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("panels filed before the options chain exists reach the AddOns tab on its first load", withClient, async () => {
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(), exercise: true,
    screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    // What a module does at its load: a panel and a child panel under it.
    lua(boot, `
      local panel = CreateFrame("Frame", "QueueTestPanel", UIParent)
      panel.name = "Очередь"
      InterfaceOptions_AddCategory(panel)
      local child = CreateFrame("Frame", "QueueTestChild", UIParent)
      child.name = "Дочерняя"
      child.parent = "Очередь"
      InterfaceOptions_AddCategory(child)
      QUEUE_TEST_HANDLERS = type(panel.okay) == "function" and type(panel.refresh) == "function"
    `, 0);
    assert.equal(boot.vm.getGlobal("QUEUE_TEST_HANDLERS"), true, "the frame's handlers are filled at the call, as the stock does");
    assert.equal(lua(boot, "return INTERFACEOPTIONS_ADDONCATEGORIES == nil and 1 or 0")[0], 1, "the chain is not loaded yet");
    const errors = boot.errorCount;
    const result = await loadFrameXmlOptionsChain(boot, { preset() {}, storageNote: () => "" });
    assert.equal(result.ok, true, result.message);
    assert.equal(boot.errorCount, errors);
    const [count, first, second, childHidden, parentHasChildren] = lua(boot, `
      local categories = INTERFACEOPTIONS_ADDONCATEGORIES
      return #categories, categories[1] and categories[1].name, categories[2] and categories[2].name,
        QueueTestChild.hidden and 1 or 0, QueueTestPanel.hasChildren and 1 or 0`, 5);
    assert.deepEqual([count, first, second, childHidden, parentHasChildren], [2, "Очередь", "Дочерняя", 1, 1]);
    // From now on the real function answers directly.
    lua(boot, `
      local late = CreateFrame("Frame", "QueueTestLate", UIParent)
      late.name = "Поздняя"
      InterfaceOptions_AddCategory(late)`, 0);
    assert.equal(lua(boot, "return #INTERFACEOPTIONS_ADDONCATEGORIES")[0], 3);
  } finally {
    boot.close();
  }
});

test("a boot that runs the real function itself keeps it (the stand-in only fills the gap)", async () => {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Options.lua\nAddon.lua",
      "interface/framexml/options.lua": "REAL_CALLS = 0\nfunction InterfaceOptions_AddCategory(frame) REAL_CALLS = REAL_CALLS + 1 end",
      "interface/framexml/addon.lua": "InterfaceOptions_AddCategory({ name = 'x' })",
    }),
    exercise: false,
  });
  try {
    await boot.load();
    assert.equal(boot.vm.getGlobal("REAL_CALLS"), 1);
  } finally {
    boot.close();
  }
});
